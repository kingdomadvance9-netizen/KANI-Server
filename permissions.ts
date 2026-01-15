/**
 * Role-Based Access Control (RBAC) Permission System
 *
 * This module provides centralized permission checking for all admin actions
 * in the video conferencing system.
 */

import { PrismaClient } from "./generated/prisma";

const prisma = new PrismaClient();

// ============================================================================
// TYPES
// ============================================================================

export type Role = "HOST" | "COHOST" | "PARTICIPANT";

export type ControlAction =
  | "MAKE_HOST"
  | "REMOVE_HOST"
  | "MAKE_COHOST"
  | "REMOVE_COHOST"
  | "MUTE_INDIVIDUAL"
  | "UNMUTE_INDIVIDUAL"
  | "DISABLE_CAMERA"
  | "ENABLE_CAMERA"
  | "STOP_SCREENSHARE"
  | "REMOVE_FROM_ROOM"
  | "GLOBAL_MUTE"
  | "GLOBAL_UNMUTE"
  | "GLOBAL_CAMERA_DISABLE"
  | "GLOBAL_CAMERA_ENABLE"
  | "GLOBAL_SCREENSHARE_DISABLE"
  | "GLOBAL_SCREENSHARE_ENABLE";

export interface PermissionResult {
  allowed: boolean;
  reason?: string;
  shouldAuditLog?: boolean;
}

interface PermissionRule {
  allowed: boolean;
  denialReason?: string;
}

// ============================================================================
// PERMISSION MATRIX
// ============================================================================

const PERMISSION_MATRIX: Record<
  ControlAction,
  Record<Role, Record<Role, PermissionRule>>
> = {
  MAKE_HOST: {
    HOST: {
      HOST: { allowed: true },
      COHOST: { allowed: true },
      PARTICIPANT: { allowed: true },
    },
    COHOST: {
      HOST: { allowed: false, denialReason: "COHOST_CANNOT_MANAGE_HOST" },
      COHOST: { allowed: false, denialReason: "COHOST_CANNOT_PROMOTE" },
      PARTICIPANT: { allowed: false, denialReason: "COHOST_CANNOT_PROMOTE" },
    },
    PARTICIPANT: {
      HOST: { allowed: false, denialReason: "NO_ADMIN_PRIVILEGES" },
      COHOST: { allowed: false, denialReason: "NO_ADMIN_PRIVILEGES" },
      PARTICIPANT: { allowed: false, denialReason: "NO_ADMIN_PRIVILEGES" },
    },
  },

  REMOVE_HOST: {
    HOST: {
      HOST: { allowed: true },
      COHOST: { allowed: false },
      PARTICIPANT: { allowed: false },
    },
    COHOST: {
      HOST: { allowed: false, denialReason: "COHOST_CANNOT_MANAGE_HOST" },
      COHOST: { allowed: false, denialReason: "COHOST_CANNOT_DEMOTE" },
      PARTICIPANT: { allowed: false, denialReason: "INVALID_TARGET" },
    },
    PARTICIPANT: {
      HOST: { allowed: false, denialReason: "NO_ADMIN_PRIVILEGES" },
      COHOST: { allowed: false, denialReason: "NO_ADMIN_PRIVILEGES" },
      PARTICIPANT: { allowed: false, denialReason: "NO_ADMIN_PRIVILEGES" },
    },
  },

  MAKE_COHOST: {
    HOST: {
      HOST: { allowed: false, denialReason: "TARGET_ALREADY_HOST" },
      COHOST: { allowed: true },
      PARTICIPANT: { allowed: true },
    },
    COHOST: {
      HOST: { allowed: false, denialReason: "COHOST_CANNOT_PROMOTE" },
      COHOST: { allowed: false, denialReason: "COHOST_CANNOT_PROMOTE" },
      PARTICIPANT: { allowed: false, denialReason: "COHOST_CANNOT_PROMOTE" },
    },
    PARTICIPANT: {
      HOST: { allowed: false, denialReason: "NO_ADMIN_PRIVILEGES" },
      COHOST: { allowed: false, denialReason: "NO_ADMIN_PRIVILEGES" },
      PARTICIPANT: { allowed: false, denialReason: "NO_ADMIN_PRIVILEGES" },
    },
  },

  REMOVE_COHOST: {
    HOST: {
      HOST: { allowed: false },
      COHOST: { allowed: true },
      PARTICIPANT: { allowed: false },
    },
    COHOST: {
      HOST: { allowed: false, denialReason: "COHOST_CANNOT_MANAGE_HOST" },
      COHOST: { allowed: false, denialReason: "COHOST_CANNOT_DEMOTE" },
      PARTICIPANT: { allowed: false, denialReason: "INVALID_TARGET" },
    },
    PARTICIPANT: {
      HOST: { allowed: false, denialReason: "NO_ADMIN_PRIVILEGES" },
      COHOST: { allowed: false, denialReason: "NO_ADMIN_PRIVILEGES" },
      PARTICIPANT: { allowed: false, denialReason: "NO_ADMIN_PRIVILEGES" },
    },
  },

  MUTE_INDIVIDUAL: {
    HOST: {
      HOST: { allowed: true },
      COHOST: { allowed: true },
      PARTICIPANT: { allowed: true },
    },
    COHOST: {
      HOST: { allowed: false, denialReason: "COHOST_CANNOT_MUTE_HOST" },
      COHOST: { allowed: true },
      PARTICIPANT: { allowed: true },
    },
    PARTICIPANT: {
      HOST: { allowed: false, denialReason: "NO_ADMIN_PRIVILEGES" },
      COHOST: { allowed: false, denialReason: "NO_ADMIN_PRIVILEGES" },
      PARTICIPANT: { allowed: false, denialReason: "NO_ADMIN_PRIVILEGES" },
    },
  },

  UNMUTE_INDIVIDUAL: {
    HOST: {
      HOST: { allowed: true },
      COHOST: { allowed: true },
      PARTICIPANT: { allowed: true },
    },
    COHOST: {
      HOST: { allowed: false, denialReason: "COHOST_CANNOT_CONTROL_HOST" },
      COHOST: { allowed: true },
      PARTICIPANT: { allowed: true },
    },
    PARTICIPANT: {
      HOST: { allowed: false, denialReason: "NO_ADMIN_PRIVILEGES" },
      COHOST: { allowed: false, denialReason: "NO_ADMIN_PRIVILEGES" },
      PARTICIPANT: { allowed: false, denialReason: "NO_ADMIN_PRIVILEGES" },
    },
  },

  DISABLE_CAMERA: {
    HOST: {
      HOST: { allowed: true },
      COHOST: { allowed: true },
      PARTICIPANT: { allowed: true },
    },
    COHOST: {
      HOST: { allowed: false, denialReason: "COHOST_CANNOT_CONTROL_HOST" },
      COHOST: { allowed: true },
      PARTICIPANT: { allowed: true },
    },
    PARTICIPANT: {
      HOST: { allowed: false, denialReason: "NO_ADMIN_PRIVILEGES" },
      COHOST: { allowed: false, denialReason: "NO_ADMIN_PRIVILEGES" },
      PARTICIPANT: { allowed: false, denialReason: "NO_ADMIN_PRIVILEGES" },
    },
  },

  ENABLE_CAMERA: {
    HOST: {
      HOST: { allowed: true },
      COHOST: { allowed: true },
      PARTICIPANT: { allowed: true },
    },
    COHOST: {
      HOST: { allowed: false, denialReason: "COHOST_CANNOT_CONTROL_HOST" },
      COHOST: { allowed: true },
      PARTICIPANT: { allowed: true },
    },
    PARTICIPANT: {
      HOST: { allowed: false, denialReason: "NO_ADMIN_PRIVILEGES" },
      COHOST: { allowed: false, denialReason: "NO_ADMIN_PRIVILEGES" },
      PARTICIPANT: { allowed: false, denialReason: "NO_ADMIN_PRIVILEGES" },
    },
  },

  STOP_SCREENSHARE: {
    HOST: {
      HOST: { allowed: true },
      COHOST: { allowed: true },
      PARTICIPANT: { allowed: true },
    },
    COHOST: {
      HOST: { allowed: false, denialReason: "COHOST_CANNOT_CONTROL_HOST" },
      COHOST: { allowed: true },
      PARTICIPANT: { allowed: true },
    },
    PARTICIPANT: {
      HOST: { allowed: false, denialReason: "NO_ADMIN_PRIVILEGES" },
      COHOST: { allowed: false, denialReason: "NO_ADMIN_PRIVILEGES" },
      PARTICIPANT: { allowed: false, denialReason: "NO_ADMIN_PRIVILEGES" },
    },
  },

  REMOVE_FROM_ROOM: {
    HOST: {
      HOST: { allowed: true },
      COHOST: { allowed: true },
      PARTICIPANT: { allowed: true },
    },
    COHOST: {
      HOST: { allowed: false, denialReason: "COHOST_CANNOT_KICK_HOST" },
      COHOST: { allowed: false, denialReason: "COHOST_CANNOT_KICK_COHOST" },
      PARTICIPANT: { allowed: true },
    },
    PARTICIPANT: {
      HOST: { allowed: false, denialReason: "NO_ADMIN_PRIVILEGES" },
      COHOST: { allowed: false, denialReason: "NO_ADMIN_PRIVILEGES" },
      PARTICIPANT: { allowed: false, denialReason: "NO_ADMIN_PRIVILEGES" },
    },
  },

  // Global controls - permission to execute, but hosts/co-hosts are exempt from effects
  GLOBAL_MUTE: {
    HOST: {
      HOST: { allowed: true },
      COHOST: { allowed: true },
      PARTICIPANT: { allowed: true },
    },
    COHOST: {
      HOST: { allowed: true },
      COHOST: { allowed: true },
      PARTICIPANT: { allowed: true },
    },
    PARTICIPANT: {
      HOST: { allowed: false, denialReason: "NO_ADMIN_PRIVILEGES" },
      COHOST: { allowed: false, denialReason: "NO_ADMIN_PRIVILEGES" },
      PARTICIPANT: { allowed: false, denialReason: "NO_ADMIN_PRIVILEGES" },
    },
  },

  GLOBAL_UNMUTE: {
    HOST: {
      HOST: { allowed: true },
      COHOST: { allowed: true },
      PARTICIPANT: { allowed: true },
    },
    COHOST: {
      HOST: { allowed: true },
      COHOST: { allowed: true },
      PARTICIPANT: { allowed: true },
    },
    PARTICIPANT: {
      HOST: { allowed: false, denialReason: "NO_ADMIN_PRIVILEGES" },
      COHOST: { allowed: false, denialReason: "NO_ADMIN_PRIVILEGES" },
      PARTICIPANT: { allowed: false, denialReason: "NO_ADMIN_PRIVILEGES" },
    },
  },

  GLOBAL_CAMERA_DISABLE: {
    HOST: {
      HOST: { allowed: true },
      COHOST: { allowed: true },
      PARTICIPANT: { allowed: true },
    },
    COHOST: {
      HOST: { allowed: true },
      COHOST: { allowed: true },
      PARTICIPANT: { allowed: true },
    },
    PARTICIPANT: {
      HOST: { allowed: false, denialReason: "NO_ADMIN_PRIVILEGES" },
      COHOST: { allowed: false, denialReason: "NO_ADMIN_PRIVILEGES" },
      PARTICIPANT: { allowed: false, denialReason: "NO_ADMIN_PRIVILEGES" },
    },
  },

  GLOBAL_CAMERA_ENABLE: {
    HOST: {
      HOST: { allowed: true },
      COHOST: { allowed: true },
      PARTICIPANT: { allowed: true },
    },
    COHOST: {
      HOST: { allowed: true },
      COHOST: { allowed: true },
      PARTICIPANT: { allowed: true },
    },
    PARTICIPANT: {
      HOST: { allowed: false, denialReason: "NO_ADMIN_PRIVILEGES" },
      COHOST: { allowed: false, denialReason: "NO_ADMIN_PRIVILEGES" },
      PARTICIPANT: { allowed: false, denialReason: "NO_ADMIN_PRIVILEGES" },
    },
  },

  GLOBAL_SCREENSHARE_DISABLE: {
    HOST: {
      HOST: { allowed: true },
      COHOST: { allowed: true },
      PARTICIPANT: { allowed: true },
    },
    COHOST: {
      HOST: { allowed: true },
      COHOST: { allowed: true },
      PARTICIPANT: { allowed: true },
    },
    PARTICIPANT: {
      HOST: { allowed: false, denialReason: "NO_ADMIN_PRIVILEGES" },
      COHOST: { allowed: false, denialReason: "NO_ADMIN_PRIVILEGES" },
      PARTICIPANT: { allowed: false, denialReason: "NO_ADMIN_PRIVILEGES" },
    },
  },

  GLOBAL_SCREENSHARE_ENABLE: {
    HOST: {
      HOST: { allowed: true },
      COHOST: { allowed: true },
      PARTICIPANT: { allowed: true },
    },
    COHOST: {
      HOST: { allowed: true },
      COHOST: { allowed: true },
      PARTICIPANT: { allowed: true },
    },
    PARTICIPANT: {
      HOST: { allowed: false, denialReason: "NO_ADMIN_PRIVILEGES" },
      COHOST: { allowed: false, denialReason: "NO_ADMIN_PRIVILEGES" },
      PARTICIPANT: { allowed: false, denialReason: "NO_ADMIN_PRIVILEGES" },
    },
  },
};

// ============================================================================
// AUDIT LOGGING
// ============================================================================

interface AuditLogEntry {
  action: string;
  actor: string;
  target?: string;
  roomId: string;
  result: "ALLOWED" | "DENIED";
  reason?: string;
  timestamp: Date;
}

const auditLogs: AuditLogEntry[] = [];

export async function auditLog(entry: AuditLogEntry): Promise<void> {
  auditLogs.push(entry);

  // Log to console for monitoring
  if (entry.result === "DENIED") {
    console.warn(`🚨 AUDIT: ${entry.actor} attempted ${entry.action} on ${entry.target} - DENIED: ${entry.reason}`);
  }

  // In production, you would store this in a database or send to a logging service
  // await prisma.auditLog.create({ data: entry });
}

export function getAuditLogs(roomId?: string): AuditLogEntry[] {
  if (roomId) {
    return auditLogs.filter((log) => log.roomId === roomId);
  }
  return auditLogs;
}

// ============================================================================
// RATE LIMITING
// ============================================================================

const rateLimitMap = new Map<string, { count: number; resetTime: number }>();
const RATE_LIMIT_WINDOW = 5000; // 5 seconds
const MAX_ACTIONS_PER_WINDOW = 10;

export function checkRateLimit(userId: string): boolean {
  const now = Date.now();
  const userLimit = rateLimitMap.get(userId);

  if (!userLimit || now > userLimit.resetTime) {
    // Reset or initialize
    rateLimitMap.set(userId, { count: 1, resetTime: now + RATE_LIMIT_WINDOW });
    return true;
  }

  if (userLimit.count >= MAX_ACTIONS_PER_WINDOW) {
    console.warn(`⚠️ RATE LIMIT: ${userId} exceeded rate limit (${userLimit.count} actions)`);
    return false;
  }

  userLimit.count++;
  return true;
}

// ============================================================================
// PERMISSION CHECKING
// ============================================================================

/**
 * Central permission checker for all admin actions
 */
export async function checkPermission(
  actorUserId: string,
  roomId: string,
  action: ControlAction,
  targetUserId?: string
): Promise<PermissionResult> {
  try {
    // 1. Fetch actor role
    const actor = await prisma.roomParticipant.findUnique({
      where: { roomId_userId: { roomId, userId: actorUserId } },
    });

    if (!actor) {
      return {
        allowed: false,
        reason: "ACTOR_NOT_FOUND",
        shouldAuditLog: true,
      };
    }

    const actorRole = actor.role as Role;

    // 2. For global actions, only check actor role
    const globalActions: ControlAction[] = [
      "GLOBAL_MUTE",
      "GLOBAL_UNMUTE",
      "GLOBAL_CAMERA_DISABLE",
      "GLOBAL_CAMERA_ENABLE",
      "GLOBAL_SCREENSHARE_DISABLE",
      "GLOBAL_SCREENSHARE_ENABLE",
    ];

    if (globalActions.includes(action)) {
      const canPerform = actorRole === "HOST" || actorRole === "COHOST";

      if (!canPerform) {
        return {
          allowed: false,
          reason: "NO_ADMIN_PRIVILEGES",
          shouldAuditLog: true,
        };
      }

      return { allowed: true };
    }

    // 3. For individual actions, need target
    if (!targetUserId) {
      return {
        allowed: false,
        reason: "TARGET_REQUIRED",
        shouldAuditLog: false,
      };
    }

    // 4. Fetch target role
    const target = await prisma.roomParticipant.findUnique({
      where: { roomId_userId: { roomId, userId: targetUserId } },
    });

    if (!target) {
      return {
        allowed: false,
        reason: "TARGET_NOT_FOUND",
        shouldAuditLog: false,
      };
    }

    const targetRole = target.role as Role;

    // 5. Self-check (can't control yourself)
    if (actorUserId === targetUserId) {
      return {
        allowed: false,
        reason: "CANNOT_TARGET_SELF",
        shouldAuditLog: false,
      };
    }

    // 6. Lookup permission in matrix
    const permission = PERMISSION_MATRIX[action]?.[actorRole]?.[targetRole];

    if (!permission) {
      return {
        allowed: false,
        reason: "PERMISSION_NOT_DEFINED",
        shouldAuditLog: true,
      };
    }

    if (!permission.allowed) {
      return {
        allowed: false,
        reason: permission.denialReason || "PERMISSION_DENIED",
        shouldAuditLog: true,
      };
    }

    // 7. Additional context checks
    if (action === "REMOVE_FROM_ROOM" && targetRole === "HOST") {
      // Cannot kick the room creator
      const room = await prisma.room.findUnique({ where: { id: roomId } });
      if (room?.creatorId === targetUserId) {
        return {
          allowed: false,
          reason: "CANNOT_KICK_CREATOR",
          shouldAuditLog: true,
        };
      }
    }

    return { allowed: true };
  } catch (err) {
    console.error("Error in checkPermission:", err);
    return {
      allowed: false,
      reason: "PERMISSION_CHECK_ERROR",
      shouldAuditLog: false,
    };
  }
}

/**
 * Check if a role is exempt from global controls
 */
export function isExemptFromGlobalControls(role: Role): boolean {
  return role === "HOST" || role === "COHOST";
}

/**
 * Helper to get participants affected by global actions (only PARTICIPANT role)
 */
export async function getGlobalActionTargets(roomId: string) {
  return await prisma.roomParticipant.findMany({
    where: {
      roomId,
      role: "PARTICIPANT", // Only participants are affected
    },
  });
}

// ============================================================================
// LOCK VALIDATION
// ============================================================================

/**
 * Check if a participant can unmute themselves
 */
export async function canUnmute(
  userId: string,
  roomId: string
): Promise<{ allowed: boolean; reason?: string }> {
  try {
    const participant = await prisma.roomParticipant.findUnique({
      where: { roomId_userId: { roomId, userId } },
    });

    if (!participant) {
      return { allowed: false, reason: "PARTICIPANT_NOT_FOUND" };
    }

    // Hosts and co-hosts can always unmute
    if (isExemptFromGlobalControls(participant.role as Role)) {
      return { allowed: true };
    }

    // Check if locked
    if (participant.audioLocked) {
      return { allowed: false, reason: "AUDIO_LOCKED_BY_ADMIN" };
    }

    return { allowed: true };
  } catch (err) {
    console.error("Error in canUnmute:", err);
    return { allowed: false, reason: "VALIDATION_ERROR" };
  }
}

/**
 * Check if a participant can start screen sharing
 */
export async function canStartScreenShare(
  userId: string,
  roomId: string
): Promise<{ allowed: boolean; reason?: string }> {
  try {
    const participant = await prisma.roomParticipant.findUnique({
      where: { roomId_userId: { roomId, userId } },
    });

    if (!participant) {
      return { allowed: false, reason: "PARTICIPANT_NOT_FOUND" };
    }

    // Hosts and co-hosts can always screen share
    if (isExemptFromGlobalControls(participant.role as Role)) {
      return { allowed: true };
    }

    // Check if locked
    if (participant.screenShareLocked) {
      return { allowed: false, reason: "SCREEN_SHARE_LOCKED_BY_ADMIN" };
    }

    return { allowed: true };
  } catch (err) {
    console.error("Error in canStartScreenShare:", err);
    return { allowed: false, reason: "VALIDATION_ERROR" };
  }
}

# Co-Host Database Migration

## Overview

Added support for co-host role in the application. Co-hosts have elevated permissions between regular participants and full hosts.

## Database Changes Required

The `RoomParticipant` table's `role` field currently supports:

- `"HOST"` - Full control
- `"PARTICIPANT"` - Regular user

**NEW:** Add support for `"COHOST"` role.

## Migration Steps

Since the `role` field is already a String type (not an enum), no schema migration is strictly required. However, you should:

### Option 1: No Migration Needed (Recommended)

The existing schema already supports any string value for `role`. The backend will now recognize and use `"COHOST"` as a valid role value.

### Option 2: Add Check Constraint (Optional - For Data Integrity)

If you want to enforce valid role values at the database level, run:

```sql
-- Add check constraint to ensure role is one of the valid values
ALTER TABLE "RoomParticipant"
ADD CONSTRAINT role_check
CHECK (role IN ('HOST', 'COHOST', 'PARTICIPANT'));
```

## Backend Changes Implemented

### 1. Type Definitions

- Added `isCoHost?: boolean` to `Peer` type in `mediasoup/rooms.ts`

### 2. Socket Event Handlers

- ✅ `make-cohost` - Promote participant to co-host
- ✅ `remove-cohost` - Demote co-host to participant
- ✅ `participant-updated` - Broadcast status changes
- ✅ `cohost-granted` - Notify promoted user
- ✅ `cohost-revoked` - Notify demoted user

### 3. Permission Updates

Co-hosts now have permission to:

- ✅ Mute all participants
- ✅ Unmute all participants
- ✅ Disable all cameras
- ✅ Disable/enable global screen sharing

Co-hosts CANNOT:

- ❌ Promote/demote other co-hosts (host only)
- ❌ Remove participants from call
- ❌ End meeting for all

### 4. Participant List Updates

All `participant-list-update` emissions now include `isCoHost` field:

```typescript
{
  id: string,
  name: string,
  imageUrl?: string,
  isHost: boolean,
  isCoHost: boolean,  // ← NEW
  isAudioMuted: boolean,
  isVideoPaused: boolean
}
```

## Testing

### Test Scenarios

1. **Basic Promotion/Demotion**

   ```bash
   # Test make-cohost
   socket.emit("make-cohost", { roomId: "room123", participantId: "user456" });

   # Test remove-cohost
   socket.emit("remove-cohost", { roomId: "room123", participantId: "user456" });
   ```

2. **Co-Host Permissions**

   - Co-host should be able to mute all participants
   - Co-host should be able to disable cameras
   - Co-host should be able to control screen sharing

3. **Authorization**

   - Regular participant trying to make co-host should fail
   - Host should successfully make/remove co-hosts

4. **UI Synchronization**
   - All clients should see co-host badge (🤝)
   - Co-host status should persist in database
   - New joiners should see existing co-host statuses

## Rollback

If you need to rollback:

```sql
-- Demote all co-hosts back to participants
UPDATE "RoomParticipant"
SET role = 'PARTICIPANT'
WHERE role = 'COHOST';

-- If you added the check constraint, remove it
ALTER TABLE "RoomParticipant"
DROP CONSTRAINT IF EXISTS role_check;
```

## Frontend Integration

The frontend should listen for:

- `participant-updated` - Update participant status in UI
- `cohost-granted` - Show success toast to promoted user
- `cohost-revoked` - Show info toast to demoted user

All participant data received will include `isCoHost` field.

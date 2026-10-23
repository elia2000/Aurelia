import {
  confirmAction,
  getCliArgs,
  getPositionalArgs,
  hasForceYes,
} from "./_cli.js";
import { openDatabase, runAdminActionViaServer } from "./_db-admin.js";
import { resolveUserRow } from "../lib/dbToolHelpers.js";

async function main() {
  const args = getCliArgs();
  const positional = getPositionalArgs(args);
  const userSelector = String(positional[0] || "").trim();
  const force = hasForceYes(args);

  if (!userSelector) {
    console.error(
      "Usage: npm run db:user:reset-2fa -- <user-id-or-username> [-y|--yes]",
    );
    process.exit(1);
  }

  const dbApi = await openDatabase();
  try {
    const user = await resolveUserRow(dbApi, userSelector);
    if (!user?.id) {
      console.error("User not found.");
      process.exit(1);
    }

    const confirmed = await confirmAction({
      prompt: `Turn off two-factor authentication for "${user.username}" and sign them out everywhere?`,
      force,
      forceHint:
        "Refusing to reset two-factor authentication in non-interactive mode without -y/--yes. Run: npm run db:user:reset-2fa -- -y <user-id-or-username>",
    });
    if (!confirmed) {
      console.log("Aborted.");
      return;
    }

    const remoteResult = await runAdminActionViaServer("reset_user_2fa", {
      userSelector,
    });
    if (remoteResult) {
      console.log(
        remoteResult.reset
          ? `Server mode two-factor reset: id=${remoteResult.id} username=${remoteResult.username}`
          : `Two-factor authentication was not on for ${remoteResult.username}.`,
      );
      return;
    }

    const row = await dbApi.getRow(
      "SELECT user_id FROM user_two_factor WHERE user_id = ?",
      [user.id],
    );
    if (!row) {
      console.log(`Two-factor authentication was not on for ${user.username}.`);
      return;
    }
    await dbApi.run("BEGIN");
    try {
      await dbApi.run("DELETE FROM user_recovery_codes WHERE user_id = ?", [user.id]);
      await dbApi.run("DELETE FROM user_two_factor WHERE user_id = ?", [user.id]);
      await dbApi.run("DELETE FROM sessions WHERE user_id = ?", [user.id]);
      await dbApi.run("DELETE FROM push_subscriptions WHERE user_id = ?", [user.id]);
      await dbApi.run("COMMIT");
    } catch (error) {
      await dbApi.run("ROLLBACK");
      throw error;
    }
    await dbApi.save();

    console.log(`Two-factor reset: id=${user.id} username=${user.username}`);
    console.log("Their sessions were removed. Open connections close within a few seconds, or when the server restarts.");
  } finally {
    await dbApi.close();
  }
}

main().catch((err) => {
  console.error(err?.message || err);
  process.exit(1);
});
